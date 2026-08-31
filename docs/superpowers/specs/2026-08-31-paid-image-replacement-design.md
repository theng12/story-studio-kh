# Paid Image Replacement v1.4.92 Design

**Status:** Owner-approved after independent safety review. This is the complete contract for the second release in the adaptive image recovery program and assumes v1.4.91 is merged.

## Outcome

Story Studio will offer an image-only machine setting that may buy one replacement for an asset whose original GenStudio image task authoritatively failed. It is Off by default, requires a positive additional-credit ceiling per Story job, waits exactly 30 minutes after terminal failure was observed, resolves the exact current image price from a forced live catalogue read, and persists one deterministic replacement identity before POST.

Elapsed time alone never authorizes replacement. Audio and video are not delivered in this release.

## Scope and Existing Ownership

Supported generators are only the image flows with durable manifests, stable output identities, deterministic retry scopes, and missing-only completion audits:

- `continuity_render`
- `image_pool_generate`
- `thumb_images` through `electron/server/generators/images.ts`

Continuity and Image Pool already write `params.genstudio_recovery.assets`. Thumbnail generation currently writes its task manifest but no GenStudio recovery checkpoint, so v1.4.92 must add the same minimal accepted/failed checkpoint writes keyed by the thumbnail manifest filename before thumbnails qualify. A thumbnail without matching checkpoint, manifest, job evidence, selector, and reference identity remains manual.

For thumbnails, the exact minimal addition is:

1. after the strict accepted manifest write inside `onJobAccepted`, call `checkpointGenStudioAsset(job, filename, { operation: 'image', idempotency_key, job_id: taskId, output_path, state: 'accepted' })`;
2. after persisting a terminal failed manifest entry, write the same checkpoint with the real failed task ID/key and `state: 'failed'`;
3. if either real task ID or idempotency key is unavailable, do not fabricate it and do not enter paid wait.

No checkpoint or paid behavior is added to the retired background/scene branches that share `images.ts`.

Other image surfaces remain manual. `job-queue.ts` remains the durable Story owner; `jobs.json` is authoritative for paid-attempt state; `params.genstudio_recovery.assets`, `.task-manifest.json`, and `genstudio_jobs` remain recovery and settlement evidence; `GenStudioAdmissionPool` remains capacity/balance authority; app settings remain machine-local.

## Machine Setting and Job Snapshot

```ts
interface PaidImageReplacementSetting {
  enabled: boolean
  additional_credit_ceiling: number | null
}
```

Default: `{ enabled: false, additional_credit_ceiling: null }`. Enabling without a positive safe whole-number ceiling is invalid. The fixed wait is 30 minutes and maximum is one replacement per asset; neither is configurable in v1.4.92.

Eligible image jobs snapshot the authorization outside `params`:

```ts
interface PaidImageReplacementPolicySnapshot {
  enabled: boolean
  wait_minutes: 30
  max_replacements_per_asset: 1
  additional_credit_ceiling: number | null
  snapshotted_at: string
}
```

The setting never enters project config, generator/pipeline presets, or `usePresets`. Current machine Off is also a veto before commitment. Raising the global ceiling does not enlarge an existing snapshot.

The HTTP contract follows the repository’s flat app-settings style exactly:

```http
GET /app-settings/paid-image-replacement
PUT /app-settings/paid-image-replacement
```

Both GET response and PUT request/response use the flat body, with no wrapper:

```json
{
  "enabled": false,
  "additional_credit_ceiling": null
}
```

Invalid PUT returns 400 and preserves the previous setting. GET, PUT, eligible enqueue, and job snapshotting must leave project config and every stored preset byte-for-byte unchanged. Running identical preset save/apply behavior in cloned fixtures that differ only in this machine setting must produce byte-identical project/preset files. Source-string absence alone is not acceptance evidence.

## Exact Output Selector and Live Price

There is no `outputOptionId`. Each candidate persists and resolves this exact selector:

```ts
interface PaidImageOutputSelector {
  resolution: string
  aspect_ratio: string
  width: number
  height: number
  reference_mode: 'normal' | 'reference-guided'
}

interface PaidImageReferenceInput {
  role: string
  path: string
  sha256: string
}

interface PaidImageReferenceIdentity {
  inputs: PaidImageReferenceInput[]
  identity_hash: string
}
```

Before the **original** provider POST, each supported generator must durably persist:

- that exact selector;
- the deterministic manifest directory and manifest key;
- the exact expected output path;
- the original prompt/input hash;
- a stable ordered reference identity consisting of each submitted reference’s role, canonical owning-root path, and content SHA-256, plus a SHA-256 of the canonical ordered list. No-reference work persists the canonical empty-list identity.

The selector and reference-identity hash are included in both the original input hash and request scope/idempotency identity. A replacement reads them only from the original durable manifest/checkpoint/job attempt, verifies every referenced file still hashes identically, and reuses the same selector and ordered reference inputs. It never reconstructs them from previews, current project configuration, current model defaults, the current reference toggle, filenames found later, or current form state. Missing or changed original reference bytes block replacement.

At commitment time, force a live refresh of the selected GenStudio image model. Match exactly one `output_options[]` row on all four output fields. Zero or multiple matches block.

- `normal`: use that row’s `credits_per_image` and `price_version`.
- `reference-guided`: use that row’s `reference_generation_credits` and `reference_generation_price_version`; when the row omits both, the model-level `reference_generation_credits` and `reference_generation_price_version` may be used as the catalogue’s published reference fallback. A half-published price/version pair blocks.

Never apply normal pricing to reference-guided work, reference pricing to normal work, a model-level normal rate to a model with output rows, or a stale catalogue fallback. Require the exact request’s selector to equal the original manifest/job request facts.

The narrow forced-live image refresh must supersede any older in-flight image-catalog refresh for the same base URL/API-key cache key. The older promise may finish, but it cannot satisfy the forced call or overwrite the forced result afterward. A small per-key generation token is sufficient; do not add another cache. If the forced request itself does not return live data, commitment blocks.

“Live quote” in this release means this exact GenStudio-published per-image price/version pair from a forced live catalogue response. It is labeled as a published rate, not a quote-endpoint promise; actual settlement remains authoritative.

## Terminal and Settlement Gate

An asset may enter paid wait only after Story Studio durably proves:

- a real original task ID and idempotency key bound to the exact asset/output/input hash;
- fresh read-only control evidence `state === 'failed'`;
- an allow-listed transient infrastructure/fleet failure code;
- finite non-negative `reserved_credits`, `settled_credits`, and `released_credits` satisfying `reserved = settled + released`;
- positive settlement (exact zero/full release remains on the existing immediate safe retry path);
- expected output remains missing/unusable under the current image auditor;
- no cancellation, uncertain submission, request-in-progress, refusal, validation, auth, billing, or unavailable-product state.

The durable `terminal_observed_at` is written once. `eligible_at` must equal exactly `terminal_observed_at + 30 minutes`.

## Durable Paid-Wait State

```ts
interface PaidImageReplacementAttempt {
  asset_key: string
  manifest_dir: string
  manifest_key: string
  output_path: string
  state: 'waiting' | 'committed' | 'submitted' | 'succeeded' | 'failed' | 'blocked'
  original_task_id: string
  original_idempotency_key: string
  input_hash: string
  output_selector: PaidImageOutputSelector
  reference_inputs: PaidImageReferenceInput[]
  reference_identity_hash: string
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

A persisted job has a valid paid wait only when all are true:

1. `job.status === 'running'`, `finished_at === null`, and the eligible image executor exists.
2. The snapshotted policy is enabled with wait `30`, max `1`, and positive safe whole ceiling.
3. Exactly one current attempt for the asset is `waiting`; duplicate asset attempts invalidate the predicate.
4. Original task/key/hash/selector, stable ordered reference inputs/hash, deterministic manifest directory/key/output path, and balanced terminal settlement are complete and valid.
5. `eligible_at` is a valid ISO time exactly 30 minutes after `terminal_observed_at`.
6. The matching manifest/checkpoint binds the same asset, task, idempotency key, input hash, selector, reference identity, manifest key, and output path.
7. No replacement scope/task is recorded yet, no usable artifact exists, and no cancel/pause intent supersedes the wait.

Malformed or incomplete paid state is not “close enough.” It never schedules a timer or POST.

## Runtime and Boot Precedence

Change the queue executor contract explicitly:

```ts
type JobExecutorResult = void | { kind: 'paid-image-wait' }
type JobExecutor = (job: Job) => Promise<JobExecutorResult>
```

The three supported generators may return `{ kind: 'paid-image-wait' }`; every other executor continues returning `void`. Executor wrappers such as `guardMedia` must return the wrapped result instead of discarding it.

If an asset decision occurs inside a generator worker, it sets one job-local wait latch, stops claiming new assets, lets already-active workers checkpoint and drain, then the exported top-level generator returns the result. A nested callback return is insufficient. That invocation skips its final completion audit because the same durable job is intentionally waiting; the admitted due execution later uses the existing missing-only audit.

When `runJob` receives that result, it sets `status: 'running'`, `finished_at: null`, and `local_execution_complete: false`; preserves the duplicate lock, policy, attempt, and evidence; persists and emits the job; schedules the one bounded due timer; and returns from lifecycle processing. It must skip `assertJobDidNotDeclareIncomplete`, successful completion, provider-settlement finalization, local auto-retry, and pipeline chaining. The existing outer `finally` still releases the image lane.

`readPersistedJobs()` must classify a persisted running job in this order:

1. explicit `pause_requested` handling;
2. valid durable paid-wait predicate;
3. ordinary recoverable audio/image checkpoint handling;
4. cancellation/provider reconciliation;
5. generic `Interrupted by app restart` terminalization.

This precedence is load-bearing: a paid wait contains a terminally failed checkpoint, so the ordinary recoverable predicate rejects it and the generic fallback would otherwise destroy the wait.

For a valid paid wait:

- **boot before due:** keep `running`, keep `finished_at: null`, occupy no lane, schedule one timer for the remaining duration, and persist no invented change;
- **boot at/after due:** durably transition the same job to `queued`, retain its original `started_at` so it enters the recovery-first FIFO, enqueue it once, then pump normally;
- the boot loader and timer never call GenStudio or submit work;
- repeated load/timer delivery is idempotent.

For a job-authoritative `committed`/`submitted` attempt whose deterministic manifest location is present but whose manifest commitment side is missing, boot writes only the missing manifest fields from the `jobs.json` attempt, verifies both sides match, and queues the same job once in recovery FIFO. A conflicting non-empty manifest is never overwritten and never permits POST. Boot does not repair from manifest into a missing job attempt because `jobs.json` is the authority.

Malformed paid wait falls through to the existing safe generic classification; it is never silently repaired into authority to spend.

## Due-Time Revalidation and Commitment

When the admitted executor returns at/after due, it performs read-only prechecks 1–5 below, then enters one in-process commit mutex keyed by Story `job_id` for steps 6–11. The mutex covers the authoritative `jobs.json` reload, one-attempt and ceiling calculation, and durable attempt commit. It is not a global lock and adds no dependency.

It must:

1. re-read the original task/settlement; nonterminal, changed, unknown, or imbalanced evidence blocks;
2. re-audit disk and complete without spend if a usable artifact appeared;
3. require current machine setting On;
4. force the exact live model/output/reference price above;
5. refresh verified account balance/capacity;
6. reload the authoritative job from `jobs.json`, never trust a worker’s stale in-memory attempt array;
7. enforce one attempt per asset and the snapshotted ceiling against that reloaded job;
8. derive one deterministic fresh scope from the original terminal task ID, original selector, original reference-identity hash, and stable asset identity;
9. write the committed attempt to the authoritative job first and synchronize the in-memory job from it;
10. write the matching commitment to the already-persisted deterministic manifest directory/key second;
11. re-read/verify job and manifest agree, then leave the mutex with permission to submit/recover only that identity through normal GenStudio admission.

Conservative ceiling accounting sums `quoted_credits` for every committed/submitted/terminal replacement attempt in the authoritative reloaded job. A commitment continues to count even if GenStudio later releases credits, preventing concurrent reuse. Two asset workers that reach a barrier together serialize inside the per-job mutex, so the second observes the first durable commitment before deciding.

If the authoritative job write fails, the manifest writer is not called and no POST occurs. If the job write succeeds but the manifest write fails, the committed job attempt remains authoritative, no POST occurs, and boot/re-entry repairs the missing manifest side using its persisted location/key and same deterministic scope. No path writes manifest first; no path reconstructs a missing job attempt from manifest; no POST occurs until both durable records re-read equal.

## Cleanup

Clear the in-memory due timer when the job is cancelled, explicitly paused, cleared, terminalized, committed/requeued, or no longer satisfies the durable wait predicate. Clearing a timer never deletes the durable attempt/evidence. Turning the setting Off leaves evidence intact and blocks commitment.

Replacement success must pass the existing file decoder and expected-versus-present audit. Failure preserves all artifacts/evidence and never chains a second paid attempt.

## UI Contract

This Mac settings copy:

> **Automatically buy one replacement for a confirmed failed image**
>
> Off by default. Story Studio reconnects to the original GenStudio task first. After GenStudio confirms that task failed, Story Studio waits 30 minutes, checks the image is still missing, refreshes the exact current price, and may buy one replacement within your per-Story-job credit limit. Time alone never proves a task stopped.

Show native On/Off, required **Maximum additional credits per Story job**, fixed `30-minute wait`, and `Maximum 1 replacement per image`. Jobs show waiting, committed, blocked, submitted, and actual settled state without exposing IDs outside Technical details or claiming “free”/“no duplicate charge” without proof.

## Tests and Acceptance

| Scenario | Required result |
|---|---|
| Setting absent/malformed | Off, null ceiling |
| Enable without positive ceiling | Reject; old setting preserved |
| GET/PUT machine setting | Flat endpoint/body; project config and preset bytes unchanged |
| Preset save/apply with machine setting Off versus On | Byte-identical project/preset results; setting cannot ride either payload |
| Original request before POST | Exact selector, ordered reference identity/hash, manifest location/key, and output path are durable |
| Reference preview/config changes after original POST | Replacement uses original durable inputs or blocks; never reconstructs current values |
| 30 minutes elapse without terminal evidence | Same-task recovery only; zero replacement POSTs |
| Terminal failure + balanced positive settlement at minute 29 | Durable wait; zero POSTs |
| Boot before due | Same running wait, no lane, one timer |
| Boot at/after due | Same job queued once in recovery class; no boot POST |
| Paid-wait branch placed after generic interrupted fallback | Regression test fails |
| Duplicate boot/timer delivery | One queued copy |
| Cancel/pause/clear/terminalize while waiting | Timer removed; zero replacement POSTs |
| Manifest/checkpoint/job attempt disagree | Block/fail closed |
| Selector exact normal row | Normal price + normal version |
| Selector exact reference row | Reference price + reference version |
| Normal/reference pair missing or mixed | Block |
| Live catalogue stale/unavailable | Block |
| Older image-catalog refresh is in flight when force-live starts | Forced request does not join it; older completion cannot overwrite forced live result |
| Artifact appears during wait | Complete it; zero replacement POSTs |
| Two concurrent assets cross a barrier before ceiling commit | Per-job mutex + authoritative reload allows only the ceiling-safe commitment |
| Authoritative job write fails | Manifest untouched; zero POSTs |
| Job write succeeds and manifest write fails | Job attempt remains authority; zero POSTs; boot repairs manifest then resumes same scope |
| Crash between commitment writes or POST/accept/artifact boundaries | Same scope/key/task; at most one replacement |
| Thumbnail terminal failure without accepted/failed checkpoint | No paid wait or POST |
| Thumbnail with exact new checkpoint + manifest/job evidence | May enter the same gate as other supported images |
| Replacement fails | No second automatic paid attempt |
| Audio/video/unsupported image failure | No paid-image state or POST |

## Release and Delivery

Release independently as **v1.4.92**, only after v1.4.91 is merged:

- bump `package.json` and both root `package-lock.json` version surfaces;
- add newest-first `CHANGELOG.md` copy for the optional confirmed-failure image replacement, exact current price, wait, ceiling, and Off default;
- add no dependency;
- run focused RED/GREEN tests, rendered desktop/narrow/200% QA, and complete unfiltered `npm run verify`;
- obtain independent billing/idempotency and UX review and resolve every finding;
- push a separate verified branch, create/update a separate PR, and merge only with clean checks/review/mergeability;
- synchronize main;
- run `npm run dist:smoke` from main and verify the arm64 DMG plus bundled `app.asar` are v1.4.92.

Do not publish, sign/notarize a public build, install, tag, activate billing, or touch customer jobs.

## Non-goals

- No audio/video paid recovery.
- No replacement for succeeded-but-unavailable artifacts.
- No unsupported image surface, second attempt, unresolved/nonterminal retry, price guess, preset field, project setting, replacement Story job, database, or scheduler framework.
- No changes to v1.4.91 queue fairness or tail eligibility.
