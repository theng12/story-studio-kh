# Paid Image Replacement v1.4.92 Design

**Status:** Owner-approved after independent safety review. This is the complete contract for the second release in the adaptive image recovery program and assumes v1.4.91 is merged.

## Outcome

Story Studio will offer an image-only machine setting that may buy one replacement for an asset whose original GenStudio image task authoritatively failed. It is Off by default, requires a positive additional-credit ceiling per Story job, waits exactly 30 minutes after terminal failure was observed, resolves the exact current image price from a forced live catalogue read, and persists one deterministic replacement identity before POST.

Elapsed time alone never authorizes replacement. Audio and video are not delivered in this release.

## Scope and Existing Ownership

Supported generators are only the image flows that already have durable manifests, stable output identities, deterministic retry scopes, and missing-only completion audits:

- `continuity_render`
- `image_pool_generate`
- `thumb_images` through `electron/server/generators/images.ts`

Other image surfaces remain manual. `job-queue.ts` remains the durable Story owner; `params.genstudio_recovery.assets`, `.task-manifest.json`, and `genstudio_jobs` remain the recovery and settlement evidence; `GenStudioAdmissionPool` remains capacity/balance authority; app settings remain machine-local.

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
```

At commitment time, force a live refresh of the selected GenStudio image model. Match exactly one `output_options[]` row on all four output fields. Zero or multiple matches block.

- `normal`: use that row’s `credits_per_image` and `price_version`.
- `reference-guided`: use that row’s `reference_generation_credits` and `reference_generation_price_version`; when the row omits both, the model-level `reference_generation_credits` and `reference_generation_price_version` may be used as the catalogue’s published reference fallback. A half-published price/version pair blocks.

Never apply normal pricing to reference-guided work, reference pricing to normal work, a model-level normal rate to a model with output rows, or a stale catalogue fallback. Require the exact request’s selector to equal the original manifest/job request facts.

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

A persisted job has a valid paid wait only when all are true:

1. `job.status === 'running'`, `finished_at === null`, and the eligible image executor exists.
2. The snapshotted policy is enabled with wait `30`, max `1`, and positive safe whole ceiling.
3. Exactly one current attempt for the asset is `waiting`; duplicate asset attempts invalidate the predicate.
4. Original task/key/hash/selector and balanced terminal settlement are complete and valid.
5. `eligible_at` is a valid ISO time exactly 30 minutes after `terminal_observed_at`.
6. The matching manifest/checkpoint binds the same asset, task, idempotency key, input hash, and output path.
7. No replacement scope/task is recorded yet, no usable artifact exists, and no cancel/pause intent supersedes the wait.

Malformed or incomplete paid state is not “close enough.” It never schedules a timer or POST.

## Runtime and Boot Precedence

The generator yields one typed paid-wait result. `runJob` preserves `status: 'running'`, `finished_at: null`, the duplicate lock, policy, attempt, and evidence, then releases the image lane. One bounded per-job due timer is reconstructed from `eligible_at`; it is not a polling service.

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

Malformed paid wait falls through to the existing safe generic classification; it is never silently repaired into authority to spend.

## Due-Time Revalidation and Commitment

When the admitted executor returns at/after due, it must:

1. re-read the original task/settlement; nonterminal, changed, unknown, or imbalanced evidence blocks;
2. re-audit disk and complete without spend if a usable artifact appeared;
3. require current machine setting On;
4. force the exact live model/output/reference price above;
5. refresh verified account balance/capacity;
6. enforce one attempt per asset and the snapshotted ceiling;
7. derive one deterministic fresh scope from the original terminal task ID;
8. persist matching job attempt and manifest commitment before POST;
9. submit/recover only that committed identity through normal GenStudio admission.

Conservative ceiling accounting sums `quoted_credits` for every committed/submitted/terminal replacement attempt. A commitment continues to count even if GenStudio later releases credits, preventing concurrent reuse.

If job and manifest commitment writes are interrupted, re-entry repairs the missing side with the same deterministic scope. No POST occurs until both durable records agree.

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
| Preset save/apply | Cannot carry setting |
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
| Artifact appears during wait | Complete it; zero replacement POSTs |
| Two concurrent assets approach ceiling | Durable commitments cannot exceed ceiling |
| Crash between commitment writes or POST/accept/artifact boundaries | Same scope/key/task; at most one replacement |
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
